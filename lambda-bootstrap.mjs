/**
 * Container entrypoint.
 *
 * Reads the application secret before starting Next, so neither the MongoDB
 * connection string nor the session signing key is ever stored in a Lambda
 * environment variable where anyone with `lambda:GetFunctionConfiguration`
 * could read it.
 *
 * The secret is fetched once per execution environment (a cold start) and reused
 * by every warm invocation, exactly like the Prisma client itself.
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

async function loadSecrets() {
  // Explicit values always win - that is how the image runs locally.
  if (process.env.DATABASE_URL && process.env.JWT_SECRET) return;

  const secretArn = process.env.APP_SECRET_ARN;
  if (!secretArn) {
    throw new Error(
      'Cannot start: set DATABASE_URL and JWT_SECRET, or APP_SECRET_ARN for Secrets Manager.',
    );
  }

  const client = new SecretsManagerClient({ region: process.env.AWS_REGION });
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!response.SecretString) throw new Error('Application secret has no string value');

  const secret = JSON.parse(response.SecretString);

  if (!secret.DATABASE_URL) {
    throw new Error(
      'The application secret has no DATABASE_URL. Put the Atlas connection string in it - see docs/DEPLOYMENT.md.',
    );
  }
  if (!secret.JWT_SECRET) {
    throw new Error('The application secret has no JWT_SECRET.');
  }

  process.env.DATABASE_URL ??= secret.DATABASE_URL;
  process.env.JWT_SECRET ??= secret.JWT_SECRET;
}

try {
  await loadSecrets();
  // Next's standalone server reads PORT/HOSTNAME from the environment.
  await import('./server.js');
} catch (error) {
  // Log the reason, never the connection string or the signing key.
  console.error(
    JSON.stringify({
      level: 'error',
      message: 'API failed to start',
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
}
