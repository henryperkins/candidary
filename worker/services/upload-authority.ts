export type UploadAuthority =
  | { kind: 'guest'; actorSessionId: string; eventSessionId: string }
  | { kind: 'manager-link'; actorSessionId: string; eventSessionId: string }
  | {
      kind: 'manager-account';
      actorSessionId: string;
      hostSessionId: string;
      accountId: string;
    };
