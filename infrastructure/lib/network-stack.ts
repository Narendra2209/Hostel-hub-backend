/**
 * VPC and the Lambda's egress path.
 *
 * The database now lives in MongoDB Atlas, outside this account, so the Lambda
 * reaches it over the internet. That raises an obvious question: what stops
 * anyone who obtains the connection string from using it from anywhere?
 *
 * The answer is a fixed egress address. The Lambda runs in a private subnet
 * behind a NAT gateway with a static Elastic IP, so every connection to Atlas
 * leaves from one known address, and Atlas's Network Access list is set to allow
 * only that address. Credentials alone then stop being enough.
 *
 * The alternative - a Lambda with no VPC - has no stable outbound IP, which
 * forces Atlas to allow 0.0.0.0/0 and leaves the password as the only control.
 * The NAT gateway costs real money (roughly USD 32/month each), and that is the
 * trade being made deliberately. Development uses one; production uses two so a
 * single AZ failure cannot take the API offline.
 */
import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';
import type { AppConfig } from './config';

export interface NetworkStackProps extends StackProps {
  config: AppConfig;
}

export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly lambdaSecurityGroup: ec2.SecurityGroup;
  readonly natElasticIps: string[];

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { config } = props;

    // Allocate the Elastic IPs explicitly, so their addresses become stack
    // outputs that can be pasted into the Atlas allow-list, and so they survive
    // a redeploy rather than being reassigned.
    const eips = Array.from(
      { length: config.natGateways },
      (_, index) =>
        new ec2.CfnEIP(this, `NatEip${index + 1}`, {
          domain: 'vpc',
          tags: [{ key: 'Name', value: `${config.prefix}-nat-${index + 1}` }],
        }),
    );

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${config.prefix}-vpc`,
      maxAzs: 2,
      natGateways: config.natGateways,
      natGatewayProvider: ec2.NatProvider.gateway({
        eipAllocationIds: eips.map((eip) => eip.attrAllocationId),
      }),
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // Free, and keeps any S3 traffic off the NAT gateway.
    this.vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });

    // The connection string and the JWT signing key are read on cold start; an
    // interface endpoint keeps that fetch inside the VPC rather than routing it
    // out through the NAT gateway.
    this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    this.vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      description: 'Hostel API Lambda',
      // Outbound only - TLS to Atlas and to AWS service endpoints. Nothing in
      // the VPC may open a connection *to* the function.
      allowAllOutbound: true,
    });

    this.natElasticIps = eips.map((eip) => eip.ref);

    new CfnOutput(this, 'AtlasAllowList', {
      value: this.natElasticIps.join(', '),
      description:
        'Add these to MongoDB Atlas > Network Access. They are the only addresses the API connects from.',
    });
    new CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
  }
}
