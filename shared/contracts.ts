import type { ApiErrorBody } from './errors';

// Access links only ever grant these two. Keeping `Role` narrow is what stops a
// host account from being mistaken for something an event token can mint.
export type Role = 'guest' | 'manager';
// What a session's subject is. `host` sessions belong to an account rather than
// to one event, and no access token can produce one.
export type SessionRole = Role | 'host';
export type EventHostRole = 'owner' | 'cohost';
// Emailed codes prove control of an address. They never sign a host in on their
// own — `verify` unlocks notifications, `reset` authorizes one password change.
export type ChallengePurpose = 'verify' | 'reset';
export type NotificationKind = 'getting_started' | 'event_reminder' | 'retention_warning';
export type UploadState = 'reserved' | 'stored' | 'failed' | 'deleted';
export type ModerationStatus = 'pending' | 'approved' | 'rejected';
export type PublicationStatus = 'unpublished' | 'published' | 'hidden';
export type ExportState = 'queued' | 'running' | 'ready' | 'failed' | 'expired';

export interface ApiSuccess<T> {
  data: T;
  requestId: string;
}

export interface RegistrationPendingResponse {
  registrationPending: true;
}

export interface RegistrationCompleteResponse {
  registered: true;
  boundEvent: boolean;
}

export type ApiResult<T> = ApiSuccess<T> | ApiErrorBody;

export type EventThemePresetId =
  | 'candidary-default'
  | 'garden-party'
  | 'midnight-film'
  | 'coastal-light';

export type HexColor = `#${string}`;
export type RgbaColor = `rgb(${number} ${number} ${number} / ${number}%)`;

export interface EventThemeOverridesV1 {
  primaryColor?: HexColor;
  accentColor?: HexColor;
}

export interface EventThemeConfigV1 {
  version: 1;
  presetId: EventThemePresetId;
  overrides: EventThemeOverridesV1;
}

export interface EventThemeTokens {
  page: HexColor;
  surface: HexColor;
  raisedSurface: HexColor;
  text: HexColor;
  pageText: HexColor;
  cardText: HexColor;
  mutedText: HexColor;
  secondaryMutedText: HexColor;
  quietText: HexColor;
  requiredText: HexColor;
  selectionSummaryText: HexColor;
  primary: HexColor;
  primaryForeground: HexColor;
  primaryHover: HexColor;
  primaryOnSurface: HexColor;
  primaryShadow: RgbaColor;
  accent: HexColor;
  accentForeground: HexColor;
  accentSoft: HexColor;
  accentSoftForeground: HexColor;
  border: HexColor;
  sectionBorder: HexColor;
  rememberedNameBorder: HexColor;
  reviewDivider: HexColor;
  inputBorder: HexColor;
  focus: HexColor;
  mediaPlaceholderStart: HexColor;
  mediaPlaceholderEnd: HexColor;
  mediaPlaceholderForeground: HexColor;
  heroStart: HexColor;
  heroMid: HexColor;
  heroEnd: HexColor;
  heroOverlayTop: RgbaColor;
  heroOverlayBottom: RgbaColor;
  coverOverlayTop: RgbaColor;
  coverOverlayBottom: RgbaColor;
  coverTextScrim: RgbaColor;
  fullscreenBackdrop: HexColor;
  fullscreenForeground: HexColor;
  inputShadow: RgbaColor;
  frameShadow: RgbaColor;
  inputRadius: `${number}px`;
  actionRadius: `${number}px`;
  cardRadius: `${number}px`;
  frameRadius: `${number}px`;
}

export interface ResolvedEventTheme {
  config: EventThemeConfigV1;
  tokens: EventThemeTokens;
}

export interface EventView {
  id: string;
  slug: string;
  name: string;
  eventDate: string;
  welcomeMessage: string;
  coverObjectKey: string | null;
  uploadsEnabled: boolean;
  galleryVisible: boolean;
  moderationRequired: boolean;
  reservedMediaCount: number;
  storedMediaCount: number;
  reservedBytes: number;
  storedBytes: number;
  guestAccessExpiresAt: string;
  managementAccessExpiresAt: string;
  purgeAfter: string;
  createdAt: string;
  deletedAt: string | null;
  theme: ResolvedEventTheme;
}

export type GuestEventView = Pick<
  EventView,
  | 'id'
  | 'slug'
  | 'name'
  | 'eventDate'
  | 'welcomeMessage'
  | 'coverObjectKey'
  | 'uploadsEnabled'
  | 'galleryVisible'
  | 'moderationRequired'
  | 'theme'
>;
