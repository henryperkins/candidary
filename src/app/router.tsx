import {
  createBrowserRouter,
  createMemoryRouter,
  type MemoryRouterOpts,
  type RouteObject,
} from 'react-router-dom';
import { CreatePage } from '../pages/CreatePage';
import { EventPage } from '../pages/EventPage';
import { LandingPage } from '../pages/LandingPage';
import { ManagerPage } from '../pages/ManagerPage';

const routes: RouteObject[] = [
  { path: '/', element: <LandingPage /> },
  { path: '/create', element: <CreatePage /> },
  { path: '/event/:slug', element: <EventPage /> },
  { path: '/event/:slug/fullscreen', element: <EventPage fullscreen /> },
  { path: '/manage/event/:eventId', element: <ManagerPage /> },
  { path: '*', element: <main className="centered-state"><h1>That page wandered off.</h1><a href="/">Return to Candidary</a></main> },
];

export function createAppRouter(initialEntries?: MemoryRouterOpts['initialEntries']) {
  return initialEntries
    ? createMemoryRouter(routes, { initialEntries })
    : createBrowserRouter(routes);
}
