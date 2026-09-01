import { useState } from 'react';
import type { CurrentAvatar } from '@ccat/api-client';
import { gatewayUrl } from '../lib/api';

// SINGLE SOURCE for rendering a user avatar. Every place that shows the signed-in child's avatar
// (header, sidebar, Home mascot, Profile) renders <Avatar/>, which reads the CURRENT equipped stage
// from the profile store (profile.current_avatar, served by GET /v1/profile). When the child equips a
// new stage, Customize/AvatarControl call refreshProfile() → the store updates → every <Avatar/> flips
// at once. StageFace + emojiFor are exported so the avatar-PICKER grids (Customize, the AvatarControl
// panel) render each individual stage's face with the exact SAME image/fallback rules.

// Emoji per avatar family × stage — the labelled placeholder whenever a stage has no uploaded art (or
// the art fails to load). One map → one consistent fallback everywhere.
export const FAM_EMOJI: Record<string, string[]> = {
  animals: ['🥚', '🐣', '🐥', '🐰', '🦊', '🐺', '🦁'], fox: ['🥚', '🐣', '🐥', '🐰', '🦊', '🐺', '🦁'],
  bird: ['🥚', '🐣', '🐤', '🐦', '🕊️', '🦅', '🦉'],
  aquatic: ['🥚', '🐚', '🐟', '🐠', '🐬', '🦈', '🐋'],
  space: ['🔩', '🤖', '🛰️', '🚀', '🛸', '🌠', '🌌'],
  mythic: ['🥚', '🦎', '🐍', '🐲', '🦄', '🐉', '🔥'],
};
export const emojiFor = (key: string | null | undefined, stageNumber: number | null | undefined): string =>
  (key ? FAM_EMOJI[key.toLowerCase()] : undefined)?.[(stageNumber ?? 1) - 1] ?? '🦊';

// Resolve a stored asset URL: absolute (Supabase public URL) as-is; a gateway-relative path
// (local-disk driver, e.g. "/v1/assets/…") is joined onto the gateway origin.
export function resolveAssetUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : `${gatewayUrl}${url.startsWith('/') ? '' : '/'}${url}`;
}

// A single face: uploaded art when present and it loads, else the family/stage emoji. Never a broken
// image (onError swaps to the emoji). Used for BOTH the current avatar and the picker cells.
export function StageFace({ imageUrl, emoji, className, size = 28 }: { imageUrl: string | null | undefined; emoji: string; className?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const src = broken ? null : resolveAssetUrl(imageUrl);
  if (src) {
    return <img className={className} src={src} alt="" onError={() => setBroken(true)}
      style={{ width: size, height: size, objectFit: 'contain', borderRadius: 8, display: 'block' }} />;
  }
  return <span className={className} style={{ fontSize: Math.round(size * 0.82), lineHeight: 1 }}>{emoji}</span>;
}

// FIXED UNIVERSAL AVATAR — every student shows the SAME fox everywhere (header, sidebar footer, Home
// mascot, Profile). We intentionally do NOT read the per-user equipped stage (profile.current_avatar)
// anymore; the avatar is frozen to one fox while the Customize/Avatar picker is hidden. Props are kept
// for call-site compatibility but ignored. To re-enable per-user avatars later, restore the store-driven
// StageFace body (git history) and re-expose the picker.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function Avatar({ size = 32, className, avatar, preview }: {
  size?: number; className?: string;
  avatar?: CurrentAvatar | null;      // ignored (fixed avatar)
  preview?: boolean;                  // ignored (fixed avatar)
}) {
  return (
    <span className={className} style={{ fontSize: Math.round(size * 0.82), lineHeight: 1 }} aria-hidden>🦊</span>
  );
}
