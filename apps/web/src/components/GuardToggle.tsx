export function GuardToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className={`guard-toggle ${on ? 'is-on' : ''}`}>
      <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" aria-hidden />
      <span>
        <strong>FeeLock {on ? 'on' : 'off'}</strong>
        <span className="muted">
          {on
            ? ' · every pool is quoted and simulated from your address; only SAFE pools can be used'
            : ' · routes to the best quote with no checks, like a naive aggregator'}
        </span>
      </span>
    </label>
  );
}
