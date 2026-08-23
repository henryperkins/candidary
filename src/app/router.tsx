import {
  createBrowserRouter,
  createMemoryRouter,
  type MemoryRouterOpts,
  type RouteObject,
} from 'react-router-dom';
import { CreatePage } from '../pages/CreatePage';
import { AlbumSharePage } from '../pages/AlbumSharePage';
import { EventEntryPage } from '../pages/EventEntryPage';
import { EventEntryUnavailablePage } from '../pages/EventEntryUnavailablePage';
import { EventPage } from '../pages/EventPage';
import { LandingPage } from '../pages/LandingPage';
import { PrivacyPage, TermsPage } from '../pages/LegalPage';
import { HostEventsPage } from '../pages/HostEventsPage';
import { HostLoginPage } from '../pages/HostLoginPage';
import { HostRegisterPage } from '../pages/HostRegisterPage';
import { HostVerifyPage } from '../pages/HostVerifyPage';
import { ManagerPage } from '../pages/ManagerPage';
import { ManagementRecoveryPage } from '../pages/ManagementRecoveryPage';

const routes: RouteObject[] = [
  { path: '/', element: <LandingPage /> },
  { path: '/create', element: <CreatePage /> },
  // The site footer links to both from every page, so the routes exist before the documents do.
  { path: '/privacy', element: <PrivacyPage /> },
  { path: '/terms', element: <TermsPage /> },
  { path: '/join', element: <EventEntryPage /> },
  { path: '/album', element: <AlbumSharePage /> },
  { path: '/event/:slug', element: <EventPage /> },
  { path: '/event/:slug/fullscreen', element: <EventPage fullscreen /> },
  { path: '/manage/event/:eventId', element: <ManagerPage /> },
  { path: '/host/login', element: <HostLoginPage /> },
  { path: '/host/register', element: <HostRegisterPage /> },
  { path: '/host/events', element: <HostEventsPage /> },
  { path: '/host/verify', element: <HostVerifyPage /> },
  { path: '/recover/manage', element: <ManagementRecoveryPage /> },
  { path: '/recover/event-entry', element: <EventEntryUnavailablePage /> },
  { path: '*', element: <main className="centered-state"><h1>That page wandered off.</h1><a href="/">Return to Candidary</a></main> },
];

export function createAppRouter(initialEntries?: MemoryRouterOpts['initialEntries']) {
  return initialEntries
    ? createMemoryRouter(routes, { initialEntries })
    : createBrowserRouter(routes);
}
