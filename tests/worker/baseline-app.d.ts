declare module '*baseline-app.mjs' {
  export const createApp: typeof import('../../worker/app').createApp;
}
declare module '*build-mobile-image-migration.mjs' {
  export function prepareBaselineApp(): Promise<void>;
}
