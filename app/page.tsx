/**
 * The one HTML page this deployment serves: a signpost for anyone who opens the
 * API host in a browser. A server component with no data access - it must never
 * read the database or leak anything about the hostel it serves.
 */
export default function ApiRootPage() {
  return (
    <main
      style={{
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        lineHeight: 1.55,
        margin: '0 auto',
        maxWidth: '38rem',
        padding: '3rem 1.25rem',
      }}
    >
      <h1 style={{ fontSize: '1.4rem', marginBottom: '0.25rem' }}>Hostel Manager API</h1>
      <p style={{ color: '#555', marginTop: 0 }}>
        This host serves JSON only. Every endpoint lives under <code>/api</code> and, apart from
        the health check, requires a bearer token.
      </p>
      <p>
        Service status: <a href="/api/health">/api/health</a>
      </p>
      <p style={{ color: '#555' }}>
        The staff interface is a separate single-page application and is not served from here.
      </p>
    </main>
  );
}
