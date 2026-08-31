import { useState } from 'react';
import type { CurrentAvatar } from '@ccat/api-client';
import { gatewayUrl } from '../lib/api';
import { useApp } from '../lib/store';

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

// The CURRENT equipped avatar. Reads the profile store by default; pass `avatar`/`preview` to override
// (e.g. rendering someone else's, or a specific value). Preview/"cheat" accounts show 👀 everywhere so
// that stays consistent too. Cold-start (no profile yet) → neutral default emoji, never the wrong art.
export function Avatar({ size = 32, className, avatar, preview }: {
  size?: number; className?: string;
  avatar?: CurrentAvatar | null;      // override the store value
  preview?: boolean;                  // override is_preview
}) {
  const { profile } = useApp();
  const cur = avatar !== undefined ? avatar : (profile?.current_avatar ?? null);
  const isPreview = preview !== undefined ? preview : !!profile?.is_preview;

  if (isPreview) {
    return <span className={className} style={{ fontSize: Math.round(size * 0.82), lineHeight: 1 }} aria-hidden>👀</span>;
  }
  return (
    <StageFace
      className={className}
      size={size}
      imageUrl={cur?.image_url}
      emoji={emojiFor(cur?.family_key, cur?.stage_number)}
    />
  );
}
