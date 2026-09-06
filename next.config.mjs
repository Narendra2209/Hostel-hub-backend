/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // `standalone` emits a self-contained server bundle that the Lambda container
  // image runs directly. Without this the Docker image would need the whole
  // node_modules tree.
  output: 'standalone',

  // The shared contract package ships TypeScript sources compiled to ESM; Next
  // needs to transpile it rather than treat it as a prebuilt CommonJS dep.
  transpilePackages: ['@hostel/shared'],

  // Prisma's query engine is a native binary - keep it external so Next does
  // not try to bundle it into the serverless output.
  serverExternalPackages: ['@prisma/client', 'prisma'],

  eslint: {
    ignoreDuringBuilds: true,
  },

  poweredByHeader: false,

  experimental: {
    // Keep request bodies small; large media never touches the API - it goes
    // straight to S3 through a presigned URL.
    serverActions: {
      bodySizeLimit: '1mb',
    },
  },
};

export default nextConfig;
