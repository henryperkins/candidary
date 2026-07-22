import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

import { createAppRouter } from './app/router';
import './styles.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Candidary root element is missing.');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <RouterProvider router={createAppRouter()} />
  </React.StrictMode>,
);
