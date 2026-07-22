import { LoaderCircle, TriangleAlert } from 'lucide-react';

export function LoadingState({ label = 'Gathering the details…' }: { label?: string }) {
  return <div className="state-card" role="status"><LoaderCircle className="spin" aria-hidden="true" /><p>{label}</p></div>;
}

export function ErrorState({ message }: { message: string }) {
  return <div className="state-card state-card--error" role="alert"><TriangleAlert aria-hidden="true" /><p>{message}</p></div>;
}
