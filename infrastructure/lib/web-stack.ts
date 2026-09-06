/**
 * The React SPA: a private S3 bucket served through CloudFront.
 *
 * The bucket blocks all public access; CloudFront reaches it through an Origin
 * Access Control, so the only way to fetch the app is through the distribution.
 * 403/404 are rewritten to /index.html so client-side routes such as
 * /residents/<id> work on a hard refresh.
 */
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import type { AppConfig } from './config';

export interface WebStackProps extends StackProps {
  config: AppConfig;
}

export class WebStack extends Stack {
  readonly siteBucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly siteUrl: string;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `${config.prefix}-web-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: config.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !config.retainData,
    });

    // Strict headers for the app shell. `connect-src` has to allow the API and
    // Cognito; `img-src` allows the presigned S3 URLs that render documents.
    const responseHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `${config.prefix}-security-headers`,
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        xssProtection: { protection: true, modeBlock: true, override: true },
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            'font-src https://fonts.gstatic.com',
            "img-src 'self' data: blob: https://*.amazonaws.com",
            "connect-src 'self' https://*.amazonaws.com https://*.execute-api.*.amazonaws.com",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
          ].join('; '),
          override: true,
        },
      },
    });

    let webAcl: wafv2.CfnWebACL | undefined;
    if (config.enableWaf) {
      // CloudFront web ACLs must live in us-east-1. Deploy this stack there, or
      // set enableWaf false and attach an ACL out of band.
      webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
        name: `${config.prefix}-web-acl`,
        scope: 'CLOUDFRONT',
        defaultAction: { allow: {} },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: `${config.prefix}-web-acl`,
          sampledRequestsEnabled: true,
        },
        rules: [
          {
            name: 'AWSManagedCommonRules',
            priority: 1,
            overrideAction: { none: {} },
            statement: {
              managedRuleGroupStatement: {
                vendorName: 'AWS',
                name: 'AWSManagedRulesCommonRuleSet',
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'common-rules',
              sampledRequestsEnabled: true,
            },
          },
          {
            name: 'RateLimit',
            priority: 2,
            action: { block: {} },
            statement: {
              rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP' },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'rate-limit',
              sampledRequestsEnabled: true,
            },
          },
        ],
      });
    }

    const certificate =
      config.webDomainName && config.certificateArn
        ? acm.Certificate.fromCertificateArn(this, 'Certificate', config.certificateArn)
        : undefined;

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${config.prefix} web`,
      defaultBehavior: {
        // S3BucketOrigin.withOriginAccessControl wires up the bucket policy so
        // only this distribution can read the objects.
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: responseHeaders,
        compress: true,
      },
      defaultRootObject: 'index.html',
      // A SPA route is not an S3 key; hand the shell back and let the router
      // resolve it. A short TTL keeps a genuine 404 from being cached for long.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(5),
        },
      ],
      priceClass:
        config.stage === 'prod'
          ? cloudfront.PriceClass.PRICE_CLASS_ALL
          : cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableLogging: config.stage === 'prod',
      // minimumProtocolVersion only has an effect alongside a custom
      // certificate; with the default CloudFront certificate the policy is
      // fixed, and setting it anyway produces a misleading synth warning.
      ...(certificate && config.webDomainName
        ? {
            certificate,
            domainNames: [config.webDomainName],
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
          }
        : {}),
      ...(webAcl ? { webAclId: webAcl.attrArn } : {}),
    });

    this.siteUrl = config.webDomainName
      ? `https://${config.webDomainName}`
      : `https://${this.distribution.distributionDomainName}`;

    new CfnOutput(this, 'SiteBucketName', {
      value: this.siteBucket.bucketName,
      description: 'Upload the Vite build here',
      exportName: `${config.prefix}-site-bucket`,
    });
    new CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'Invalidate this distribution after deploying the frontend',
      exportName: `${config.prefix}-distribution-id`,
    });
    new CfnOutput(this, 'SiteUrl', { value: this.siteUrl, description: 'The application URL' });
  }
}
