import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './globals.css';
import type { Metadata } from 'next';
import { ColorSchemeScript, MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import AuthProvider from '@/components/AuthProvider';
import { EnvProvider } from '@/components/EnvProvider';
import DevImpersonationBar from '@/components/DevImpersonationBar';
import StagingBar from '@/components/StagingBar';
import DevDashboard from '@/components/DevDashboard';
import OnboardingGate from '@/components/OnboardingGate';
import RenewalBanner from '@/components/RenewalBanner';
import DbWakeNotice from '@/components/DbWakeNotice';
import AppFrame from '@/components/AppFrame';
import { UnsavedChangesProvider } from '@/components/UnsavedChangesProvider';
import { TimezoneProvider } from '@/components/TimezoneProvider';
import { brand } from '@/brand';
import { config } from '@/lib/config';
import { resolveDisplayTimezone } from '@/lib/appSettings';

// CHECKIN_ENV is read at runtime (the same image runs in prod/dev/local), so the root
// layout must render dynamically rather than baking a build-time value into static HTML.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Innovation Treehouse',
  description: 'The Innovation Treehouse next-generation check-in system',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const timezone = await resolveDisplayTimezone();
  return (
    <html lang="en" className={brand.fontVariables} suppressHydrationWarning>
      <head>
        <ColorSchemeScript defaultColorScheme="auto" />
      </head>
      <body data-brand={brand.id}>
        <TimezoneProvider value={timezone}>
          <MantineProvider theme={brand.theme} defaultColorScheme="auto">
            <ModalsProvider>
              <Notifications />
              <EnvProvider value={{ checkinEnv: config.checkinEnv(), shopifyStoreDomain: config.shopifyStoreDomain(), isStaging: config.isStaging() }}>
                <AuthProvider>
                  <OnboardingGate>
                    <StagingBar />
                    <DevImpersonationBar />
                    <UnsavedChangesProvider>
                      <AppFrame>
                        <DbWakeNotice />
                        <RenewalBanner />
                        {children}
                      </AppFrame>
                    </UnsavedChangesProvider>
                    <DevDashboard />
                  </OnboardingGate>
                </AuthProvider>
              </EnvProvider>
            </ModalsProvider>
          </MantineProvider>
        </TimezoneProvider>
      </body>
    </html>
  );
}
