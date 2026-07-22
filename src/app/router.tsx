import {
  createBrowserRouter,
  createMemoryRouter,
  type MemoryRouterOpts,
  type RouteObject,
} from 'react-router-dom';

function PlaceholderPage() {
  return <main>Candidary</main>;
}

const routes: RouteObject[] = [
  {
    path: '*',
    element: <PlaceholderPage />,
  },
];

export function createAppRouter(initialEntries?: MemoryRouterOpts['initialEntries']) {
  return initialEntries
    ? createMemoryRouter(routes, { initialEntries })
    : createBrowserRouter(routes);
}
