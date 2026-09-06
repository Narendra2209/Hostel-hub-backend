#!/usr/bin/env node
/**
 * CDK entry point.
 *
 * There is no database stack: MongoDB Atlas is managed outside this account and
 * reached over the internet from a fixed NAT address (see NetworkStack), with
 * its connection string supplied through Secrets Manager. There is no Cognito
 * stack either - the application manages its own accounts and sessions.
 *
 * Stack order and why:
 *   Network -> the VPC and the allow-listed egress address
 *   Web     -> S3 + CloudFront; created before the API so the API knows which
 *              origin to permit through CORS
 *   Api     -> the Lambda, which needs both of the above
 *
 * Deploy: npm run cdk -- deploy --all -c stage=prod
 */
import 'source-map-support/register';
import { App, Tags } from 'aws-cdk-lib';
import { resolveConfig } from '../lib/config';
import { NetworkStack } from '../lib/network-stack';
import { ApiStack } from '../lib/api-stack';
import { WebStack } from '../lib/web-stack';

const app = new App();
const config = resolveConfig(app.node);

const common = { env: config.env, config };

const network = new NetworkStack(app, `${config.prefix}-network`, {
  ...common,
  description: 'Hostel Manager - VPC and the NAT address allow-listed in Atlas',
});

const web = new WebStack(app, `${config.prefix}-web`, {
  ...common,
  description: 'Hostel Manager - React SPA on S3 behind CloudFront',
  // CloudFront web ACLs must be created in us-east-1, so the whole web stack is
  // pinned there when WAF is enabled.
  ...(config.enableWaf ? { env: { ...config.env, region: 'us-east-1' } } : {}),
  crossRegionReferences: config.enableWaf,
});

/*
 * The API allows the site's own origin, plus localhost during development so a
 * developer can point a local Vite server at a deployed API.
 */
const allowedOrigins = [
  web.siteUrl,
  ...(config.webDomainName ? [`https://${config.webDomainName}`] : []),
  ...(config.stage === 'prod' ? [] : ['http://localhost:5173']),
];

const api = new ApiStack(app, `${config.prefix}-api`, {
  ...common,
  description: 'Hostel Manager - Next.js API on Lambda behind API Gateway',
  vpc: network.vpc,
  lambdaSecurityGroup: network.lambdaSecurityGroup,
  frontendUrl: allowedOrigins.join(','),
});

api.addDependency(network);
api.addDependency(web);

Tags.of(app).add('Application', 'HostelManager');
Tags.of(app).add('Stage', config.stage);
Tags.of(app).add('ManagedBy', 'CDK');
