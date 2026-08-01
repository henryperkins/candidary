export function GuestListIntakeLauncher({
  pristine,
  onOpen,
}: {
  pristine: boolean;
  onOpen(): void;
}) {
  if (pristine) return <section className="guest-list-launcher guest-list-launcher--pristine" aria-labelledby="start-guest-list-title">
    <h3 id="start-guest-list-title">Start your guest list</h3>
    <p>Add a file, paste names from a spreadsheet, or type guests directly. You can review everything before it is added.</p>
    <button type="button" className="button button--primary" onClick={onOpen}>Add guests</button>
  </section>;
  return <div className="guest-list-launcher">
    <button type="button" className="button button--primary" onClick={onOpen}>Add guests</button>
  </div>;
}
