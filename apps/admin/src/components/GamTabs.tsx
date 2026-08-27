import React from 'react';
import { Link } from 'react-router-dom';

// In-page Gamification sub-nav pills (mockup): Achievements / Avatars 7×7 / Themes.
export function GamTabs({ active }: { active: 'achievements' | 'avatars' | 'themes' }) {
  return (
    <div className="pilltabs" style={{ marginBottom: 14 }}>
      <Link to="/gamification/achievements" className={`pilltab ${active === 'achievements' ? 'on' : ''}`}>Achievements</Link>
      <Link to="/gamification/customization" className={`pilltab ${active === 'avatars' ? 'on' : ''}`}>Avatars 7×7</Link>
      <Link to="/gamification/themes" className={`pilltab ${active === 'themes' ? 'on' : ''}`}>Themes</Link>
    </div>
  );
}
