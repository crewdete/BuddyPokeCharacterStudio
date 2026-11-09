import type { LoadState } from '../App';

export function DataPanel({ state }: { state: LoadState }) {
  if (state.status === 'loading') return <p className="muted">Decoding chick.bin…</p>;
  if (state.status === 'error') return <p className="error" role="alert">{state.message}</p>;
  const { info } = state;
  const rows: [string, string | number][] = [
    ['Bones', info.bones],
    ['Meshes', `${info.meshes} (${info.skinnedMeshes} skinned, ${info.rigidMeshes} rigid)`],
    ['Animations', info.animations],
    ['Cull regions', info.cullRegions],
    ['Props', info.props],
    ['Wardrobe options', info.wardrobeOptions],
    ['Selectors', info.selectors],
    ['Worn items (default look)', info.wornItems],
  ];
  return (
    <section>
      <p className="muted">Decoded in the studio by the unmodified BuddyRevival engine.</p>
      <dl className="facts">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <h3>Look code</h3>
      <code className="code">{info.lookCode}</code>
    </section>
  );
}
