import { useState } from 'react';
import type { ReferralInfo } from '@ccat/api-client';
import { client } from '../lib/api';
import { useApp } from '../lib/store';
import { AppBar, Card, Loader, ErrorNote, useAsync } from '../components/ui';

// Build the shareable URL from THIS client's own origin (gateway stays client-agnostic and returns
// only the relative share_path). Falls back to a bare path if origin is unavailable.
function shareUrl(path: string): string {
  try { return new URL(path, window.location.origin).toString(); } catch { return path; }
}

export function ReferralScreen() {
  const { flash } = useApp();
  const { loading, error, data, reload } = useAsync(async () => client.referrals());
  const [copied, setCopied] = useState(false);

  const url = data ? shareUrl(data.share_path) : '';
  const shareText = 'Come practise for the CCAT with me on the Concept Mastery app!';

  async function copy() {
    try { await navigator.clipboard.writeText(url); setCopied(true); flash('Invite link copied'); setTimeout(() => setCopied(false), 1600); }
    catch { flash('Copy failed — select and copy the link.'); }
  }
  async function nativeShare() {
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (nav.share) { try { await nav.share({ title: 'Concept Mastery', text: shareText, url }); } catch { /* user cancelled */ } }
    else copy();
  }
  const canNativeShare = typeof navigator !== 'undefined' && 'share' in navigator;
  const mailto = `mailto:?subject=${encodeURIComponent('Join me on Concept Mastery')}&body=${encodeURIComponent(`${shareText}\n\n${url}`)}`;

  return (
    <>
      <AppBar title="Invite friends" sub="Share your code, earn coins" back />
      <div className="content stack">
        {loading && <Loader />}
        {error && <ErrorNote error={error} onRetry={reload} />}
        {data && (
          <>
            <Card>
              <div className="eyebrow">🎁 Your invite</div>
              <div className="stack" style={{ alignItems: 'center', gap: 8, margin: '10px 0' }}>
                <div className="referral-code">{data.code}</div>
                <div className="muted" style={{ wordBreak: 'break-all', textAlign: 'center' }}>{url}</div>
              </div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                {canNativeShare && <button className="btn small" onClick={nativeShare}>📤 Share</button>}
                <button className="btn small secondary" onClick={copy}>{copied ? '✓ Copied' : '🔗 Copy link'}</button>
                <a className="btn small secondary" href={mailto}>✉️ Email</a>
              </div>
            </Card>

            <div className="row" style={{ gap: 10 }}>
              <div className="stat" style={{ flex: 1 }}><div className="n">{data.joined}</div><div className="l">Friends joined</div></div>
              <div className="stat" style={{ flex: 1 }}>
                <div className="n">{data.next ? `${data.next.to_go}` : '✓'}</div>
                <div className="l">{data.next ? `to next ${data.next.coins}🪙` : 'All rewards earned'}</div>
              </div>
            </div>

            <Card>
              <div className="eyebrow">🏆 Reward ladder</div>
              <div className="hint" style={{ margin: '6px 0 10px' }}>
                {data.next ? `Invite ${data.next.to_go} more friend${data.next.to_go === 1 ? '' : 's'} to earn ${data.next.coins} coins.` : 'You’ve earned every referral reward — amazing! 🎉'}
              </div>
              <div className="coin-ladder">
                {data.ladder.map((r) => {
                  const isNext = !!data.next && data.next.friends === r.friends;
                  return (
                    <div key={r.friends} className={`coin-rung ${r.reached ? 'reached' : ''} ${isNext ? 'next' : ''}`} title={`${r.friends} friends → ${r.coins} coins`}>
                      <span className="rung-ic">{r.reached ? '✅' : isNext ? '🎯' : '🔒'}</span>
                      <strong>{r.friends}👥</strong>
                      <span className="hint">{r.coins}🪙</span>
                    </div>
                  );
                })}
              </div>
            </Card>

            <p className="hint">Your friend enters this code (or opens your link) when they sign up. Coins are added automatically once they join.</p>
          </>
        )}
      </div>
    </>
  );
}
