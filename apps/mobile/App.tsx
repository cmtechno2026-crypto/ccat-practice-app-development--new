import React from 'react';
import { View, ActivityIndicator, StatusBar } from 'react-native';
import { useFonts, Baloo2_600SemiBold, Baloo2_700Bold } from '@expo-google-fonts/baloo-2';
import { Nunito_400Regular, Nunito_700Bold } from '@expo-google-fonts/nunito';
import { AppProvider, useApp } from './src/lib/store';
import { colors } from './src/theme';
import { WelcomeScreen } from './src/screens/WelcomeScreen';
import { LoginScreen } from './src/screens/LoginScreen';
import { RegisterScreen } from './src/screens/RegisterScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { SessionScreen } from './src/screens/SessionScreen';
import { ResultScreen } from './src/screens/ResultScreen';
import { BookmarksScreen } from './src/screens/BookmarksScreen';
import { AchievementsScreen } from './src/screens/AchievementsScreen';
import { RecoveryScreen } from './src/screens/RecoveryScreen';
import { DeviceReplaceScreen } from './src/screens/DeviceReplaceScreen';
import { CustomizeScreen } from './src/screens/CustomizeScreen';
import { BookStoreScreen } from './src/screens/BookStoreScreen';

function Router() {
  const { ready, screen } = useApp();
  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center' }}><ActivityIndicator color={colors.primary} /></View>;
  switch (screen) {
    case 'welcome': return <WelcomeScreen />;
    case 'login': return <LoginScreen />;
    case 'register': return <RegisterScreen />;
    case 'home': return <HomeScreen />;
    case 'session': return <SessionScreen />;
    case 'result': return <ResultScreen />;
    case 'bookmarks': return <BookmarksScreen />;
    case 'achievements': return <AchievementsScreen />;
    case 'recovery': return <RecoveryScreen />;
    case 'deviceReplace': return <DeviceReplaceScreen />;
    case 'customize': return <CustomizeScreen />;
    case 'bookstore': return <BookStoreScreen />;
    default: return <WelcomeScreen />;
  }
}

export default function App() {
  const [loaded] = useFonts({ Baloo2_600SemiBold, Baloo2_700Bold, Nunito_400Regular, Nunito_700Bold });
  if (!loaded) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  return (
    <AppProvider>
      <StatusBar barStyle="dark-content" />
      <Router />
    </AppProvider>
  );
}
