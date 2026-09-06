/**
 * The Next.js API on Lambda, behind an HTTP API Gateway.
 *
 * Packaging: Next is built with `output: 'standalone'` and shipped as a Lambda
 * container image running the AWS Lambda Web Adapter, which translates API
 * Gateway events into ordinary HTTP requests against the Next server. The same
 * image runs unchanged with `docker run`, so what is tested locally is what
 * ships.
 *
 * Secrets: the MongoDB connection string and the JWT signing key live in one
 * Secrets Manager secret, read at container start (see lambda-bootstrap.mjs).
 * Neither is ever placed in a Lambda environment variable, where anyone with
 * `lambda:GetFunctionConfiguration` could read it.
 *
 * A deliberate decision: authentication is NOT delegated to an API Gateway
 * authorizer. The application verifies its own session tokens - it must anyway,
 * to load the user and their current role - and doing it in one place avoids the
 * classic trap where a gateway authorizer rejects the CORS preflight because a
 * browser never sends Authorization on an OPTIONS request. CORS is likewise
 * handled by the application, which owns the origin allow-list. Edge protection
 * comes from WAF and API Gateway throttling instead.
 */
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as path from 'node:path';
import type { Construct } from 'constructs';
import type { AppConfig } from './config';

// The Docker build context is this repository's root: the API and the
// @hostel/shared workspace it depends on both live here.
const repoRoot = path.resolve(__dirname, '..', '..');

export interface ApiStackProps extends StackProps {
  config: AppConfig;
  vpc: ec2.IVpc;
  lambdaSecurityGroup: ec2.ISecurityGroup;
  /** Comma-joined origins allowed to call the API. */
  frontendUrl: string;
}

export class ApiStack extends Stack {
  readonly httpApi: apigwv2.HttpApi;
  readonly apiFunction: lambda.DockerImageFunction;
  readonly appSecret: secretsmanager.Secret;
  readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config } = props;

    /*
     * One secret with two keys:
     *   DATABASE_URL - the Atlas connection string, including credentials
     *   JWT_SECRET   - the session signing key
     *
     * DATABASE_URL cannot be generated, so it starts empty and is filled in
     * after deployment (see docs/DEPLOYMENT.md). JWT_SECRET is generated here so
     * a strong value exists from the first deploy and never passes through a
     * shell, a terminal history or a CI log. Rotating it signs everybody out.
     */
    this.appSecret = new secretsmanager.Secret(this, 'AppSecret', {
      secretName: `${config.prefix}/app`,
      description: 'Hostel Manager - MongoDB connection string and session signing key',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ DATABASE_URL: '' }),
        generateStringKey: 'JWT_SECRET',
        passwordLength: 64,
        excludePunctuation: true,
      },
      removalPolicy: config.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.apiFunction = new lambda.DockerImageFunction(this, 'ApiFunction', {
      functionName: `${config.prefix}-api`,
      description: 'Hostel Manager Next.js API',
      code: lambda.DockerImageCode.fromImageAsset(repoRoot, {
        file: 'Dockerfile',
        exclude: [
          'node_modules',
          '**/node_modules',
          '**/.next',
          '**/dist',
          'infrastructure/cdk.out',
          '.git',
        ],
      }),
      memorySize: config.apiMemoryMb,
      timeout: Duration.seconds(config.apiTimeoutSeconds),
      architecture: lambda.Architecture.X86_64,
      // In the VPC so Atlas sees a single, allow-listed NAT address.
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSecurityGroup],
      logRetention: config.logRetentionDays,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        NODE_ENV: 'production',
        AWS_LWA_PORT: '4000',
        // Give the container a moment to boot Next before the adapter probes it.
        AWS_LWA_READINESS_CHECK_PATH: '/api/health',
        AWS_LWA_ENABLE_COMPRESSION: 'true',

        APP_SECRET_ARN: this.appSecret.secretArn,
        FRONTEND_URL: props.frontendUrl,
        MAX_UPLOAD_MB: String(config.maxUploadMb),
        SESSION_TTL_HOURS: String(config.sessionTtlHours),
        LOG_LEVEL: config.stage === 'prod' ? 'info' : 'debug',
      },
    });

    // Least privilege: the function may read exactly one secret and nothing else.
    this.appSecret.grantRead(this.apiFunction);

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${config.prefix}-api`,
      description: 'Hostel Manager REST API',
      // CORS is handled by the application so the origin allow-list lives in one
      // place; configuring it here as well would emit duplicate headers.
      createDefaultStage: false,
    });

    const integration = new HttpLambdaIntegration('ApiIntegration', this.apiFunction, {
      payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
      timeout: Duration.seconds(Math.min(config.apiTimeoutSeconds, 29)),
    });

    this.httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration,
    });
    this.httpApi.addRoutes({ path: '/', methods: [apigwv2.HttpMethod.ANY], integration });

    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: `/aws/apigateway/${config.prefix}-api`,
      retention: config.logRetentionDays,
    });

    const stage = new apigwv2.HttpStage(this, 'DefaultStage', {
      httpApi: this.httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: {
        // A hostel has tens of users, not thousands. This is the real rate
        // limit; the in-process limiter in the app is only a backstop.
        rateLimit: config.stage === 'prod' ? 200 : 50,
        burstLimit: config.stage === 'prod' ? 400 : 100,
      },
    });

    // CDK does not expose access logging on HttpStage directly.
    const cfnStage = stage.node.defaultChild as apigwv2.CfnStage;
    cfnStage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        ip: '$context.identity.sourceIp',
        method: '$context.httpMethod',
        path: '$context.path',
        status: '$context.status',
        latency: '$context.responseLatency',
        integrationStatus: '$context.integrationStatus',
      }),
    };

    this.apiUrl = `${this.httpApi.apiEndpoint}/api`;

    /* ---------------- alarms ---------------- */

    new cloudwatch.Alarm(this, 'ApiErrorAlarm', {
      alarmName: `${config.prefix}-api-5xx`,
      metric: this.apiFunction.metricErrors({ period: Duration.minutes(5) }),
      threshold: config.stage === 'prod' ? 5 : 20,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Hostel API is returning errors',
    });

    new cloudwatch.Alarm(this, 'ApiThrottleAlarm', {
      alarmName: `${config.prefix}-api-throttles`,
      metric: this.apiFunction.metricThrottles({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Hostel API Lambda is being throttled',
    });

    new CfnOutput(this, 'ApiEndpoint', {
      value: this.httpApi.apiEndpoint,
      description: 'API Gateway endpoint',
      exportName: `${config.prefix}-api-endpoint`,
    });
    new CfnOutput(this, 'ApiBaseUrl', {
      value: this.apiUrl,
      description: 'VITE_API_BASE_URL for the web build',
    });
    new CfnOutput(this, 'AppSecretArn', {
      value: this.appSecret.secretArn,
      description: 'Put the Atlas connection string in this secret under DATABASE_URL',
    });
  }
}
