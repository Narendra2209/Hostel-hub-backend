/**
 * Deployment configuration.
 *
 * Everything environment-specific is resolved here from CDK context or
 * environment variables, so the stacks themselves contain no hardcoded account
 * ids, domains or sizing decisions.
 *
 * The database is MongoDB Atlas, managed outside this account, so there is no
 * database stack: the connection string is supplied through Secrets Manager.
 */
import type { Environment } from 'aws-cdk-lib';

export type StageName = 'dev' | 'staging' | 'prod';

export interface AppConfig {
  stage: StageName;
  /** Resource name prefix, e.g. "hostel-prod". */
  prefix: string;
  env: Environment;
  /** Keep secrets and buckets when the stack is destroyed. */
  retainData: boolean;
  /** NAT gateways cost money; one is plenty outside production. */
  natGateways: number;
  logRetentionDays: number;
  apiMemoryMb: number;
  apiTimeoutSeconds: number;
  /** Largest document the upload endpoints accept. */
  maxUploadMb: number;
  /** How long a session token stays valid. */
  sessionTtlHours: number;
  /** Optional custom domain for the SPA. Leave undefined to use the CloudFront domain. */
  webDomainName?: string;
  /** ACM certificate ARN in us-east-1, required only when webDomainName is set. */
  certificateArn?: string;
  /** Attach an AWS WAF web ACL to CloudFront and the API. */
  enableWaf: boolean;
  /**
   * No longer used for account creation - the first owner is created through the
   * application's own first-run screen. Kept only to address alarms.
   */
  bootstrapAdminEmail?: string;
  alarmEmail?: string;
}

const STAGE_DEFAULTS: Record<StageName, Omit<AppConfig, 'stage' | 'prefix' | 'env'>> = {
  dev: {
    retainData: false,
    natGateways: 1,
    logRetentionDays: 14,
    apiMemoryMb: 1024,
    apiTimeoutSeconds: 30,
    maxUploadMb: 15,
    sessionTtlHours: 12,
    enableWaf: false,
  },
  staging: {
    retainData: true,
    natGateways: 1,
    logRetentionDays: 30,
    apiMemoryMb: 1024,
    apiTimeoutSeconds: 30,
    maxUploadMb: 15,
    sessionTtlHours: 12,
    enableWaf: false,
  },
  prod: {
    retainData: true,
    natGateways: 2,
    logRetentionDays: 90,
    apiMemoryMb: 1536,
    apiTimeoutSeconds: 30,
    maxUploadMb: 15,
    sessionTtlHours: 8,
    enableWaf: true,
  },
};

export function resolveConfig(node: {
  tryGetContext: (key: string) => unknown;
}): AppConfig {
  const stage = ((node.tryGetContext('stage') as string) ??
    process.env.STAGE ??
    'dev') as StageName;

  if (!['dev', 'staging', 'prod'].includes(stage)) {
    throw new Error(`Unknown stage "${stage}". Use dev, staging or prod.`);
  }

  const account =
    (node.tryGetContext('account') as string) ??
    process.env.CDK_DEPLOY_ACCOUNT ??
    process.env.CDK_DEFAULT_ACCOUNT;

  const region =
    (node.tryGetContext('region') as string) ??
    process.env.CDK_DEPLOY_REGION ??
    process.env.CDK_DEFAULT_REGION ??
    'ap-south-1';

  const asString = (key: string): string | undefined => {
    const value = node.tryGetContext(key);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  return {
    stage,
    prefix: `hostel-${stage}`,
    env: { account, region },
    ...STAGE_DEFAULTS[stage],
    webDomainName: asString('webDomainName'),
    certificateArn: asString('certificateArn'),
    bootstrapAdminEmail: asString('adminEmail') ?? process.env.BOOTSTRAP_ADMIN_EMAIL,
    alarmEmail: asString('alarmEmail') ?? process.env.ALARM_EMAIL,
  };
}
