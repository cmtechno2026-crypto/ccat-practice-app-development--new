import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { channelEnabled } from '@ccat/client-core';
import { useApp } from './lib/store';
import { Loader, Toast } from './components/ui';
import { Sidebar } from './components/Sidebar';

import { WelcomeScreen } from './screens/WelcomeScreen';
import { RegisterScreen } from './screens/RegisterScreen';
import { LoginScreen } from './screens/LoginScreen';
import { RecoveryScreen } from './screens/RecoveryScreen';
import { DeviceReplaceScreen } from './screens/DeviceReplaceScreen';
import { HomeScreen } from './screens/HomeScreen';
import { PracticeScreen } from './screens/PracticeScreen';
import { SessionScreen } from './screens/SessionScreen';
import { ResultScreen } from './screens/ResultScreen';
import { RewardsScreen } from './screens/RewardsScreen';
import { ProgressScreen } from './screens/ProgressScreen';
import { BookmarksScreen } from './screens/BookmarksScreen';
import { CustomizeScreen } from './screens/CustomizeScreen';
import { ProfileScreen } from './screens/ProfileScreen';
import { UnavailableScreen } from './screens/UnavailableScreen';
import { HelpScreen } from './screens/HelpScreen';
import { ReferralScreen } from './screens/ReferralScreen';

// Routes without the app chrome (pre-auth): welcome/login/register/recovery/device.
const AUTH_ROUTES = ['/', '/login', '/register', '/recovery', '/device'];

function Protected({ children }: { children: JSX.Element }) {
  const { profile } = useApp();
  const loc = useLocation();
  if (!profile) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return children;
}

const RoutesTree = ({ profile }: { profile: unknown }) => (
  <Routes>
    <Route path="/" element={<WelcomeScreen />} />
    <Route path="/register" element={<RegisterScreen />} />
    <Route path="/login" element={<LoginScreen />} />
    <Route path="/recovery" element={<RecoveryScreen />} />
    <Route path="/device" element={<DeviceReplaceScreen />} />
    <Route path="/home" element={<Protected><HomeScreen /></Protected>} />
    <Route path="/practice" element={<Protected><PracticeScreen /></Protected>} />
    <Route path="/session/:id" element={<Protected><SessionScreen /></Protected>} />
    <Route path="/result/:id" element={<Protected><ResultScreen /></Protected>} />
    <Route path="/rewards" element={<Protected><RewardsScreen /></Protected>} />
    <Route path="/progress" element={<Protected><ProgressScreen /></Protected>} />
    <Route path="/bookmarks" element={<Protected><BookmarksScreen /></Protected>} />
    <Route path="/customize" element={<Protected><CustomizeScreen /></Protected>} />
    <Route path="/profile" element={<Protected><ProfileScreen /></Protected>} />
    <Route path="/help" element={<Protected><HelpScreen /></Protected>} />
    <Route path="/referrals" element={<Protected><ReferralScreen /></Protected>} />
    <Route path="*" element={<Navigate to={profile ? '/home' : '/'} replace />} />
  </Routes>
);

export function App() {
  const { ready, appConfig, profile } = useApp();
  const loc = useLocation();
  if (!ready) return <div className="app-root"><Loader /></div>;
  if (!channelEnabled(appConfig, 'web')) return <UnavailableScreen />;

  // Persistent left sidebar on every in-app (authenticated) page; pre-auth pages are full-width.
  const showSidebar = !!profile && !AUTH_ROUTES.includes(loc.pathname);

  return (
    <div className="app-root">
      {profile?.is_preview && (
        <div className="preview-ribbon" role="status">
          👀 Preview mode — demo account ({profile.username}). Not a real customer; this is synthetic data.
        </div>
      )}
      {showSidebar ? (
        <div className="layout">
          <Sidebar />
          <main className="main"><RoutesTree profile={profile} /></main>
        </div>
      ) : (
        <RoutesTree profile={profile} />
      )}
      <Toast />
    </div>
  );
}
