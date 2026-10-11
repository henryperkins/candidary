export function GuestListIntakeLauncher({
  pristine,
  onOpen,
}: {
  pristine: boolean;
  onOpen(): void;
}) {
  if (pristine) return <section className="guest-list-launcher guest-list-launcher--pristine" aria-labelledby="start-guest-list-title">
    <h3 id="start-guest-list-title">Start your guest list</h3>
    <p>For optional attendance replies, add a file, paste spreadsheet names, or type guests. Review them before adding.</p>
    <button type="button" className="button button--primary" data-host-tour-anchor="rsvp" data-host-tour-roster={pristine ? 'pristine' : 'review'} onClick={onOpen}>Add guests</button>
  </section>;
  return <div className="guest-list-launcher">
    <button type="button" className="button button--primary" data-host-tour-anchor="rsvp" data-host-tour-roster={pristine ? 'pristine' : 'review'} onClick={onOpen}>Add guests</button>
  </div>;
}
