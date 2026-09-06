/**
 * Root layout.
 *
 * This deployment is an API, not a website: the user interface is the separate
 * Vite SPA in apps/web. Next.js still requires one root layout for the App
 * Router to boot, so this is deliberately the smallest legal document - no
 * client bundle, no fonts, no providers.
 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Hostel Manager API',
  description: 'JSON API for the Hostel Manager application.',
  // Nothing here should ever be indexed; the only public route is /api/health.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
