// Shown when the gateway app-config disables the web channel (flag-ready; see client-core).
export function UnavailableScreen() {
  return (
    <div className="content center-narrow" style={{ paddingTop: 64, textAlign: 'center' }}>
      <div style={{ fontSize: 56 }}>🛠️</div>
      <h1>We'll be right back</h1>
      <p className="muted">The website is temporarily unavailable. Please try again soon, or use the Concept Mastery app.</p>
    </div>
  );
}
