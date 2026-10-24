import { createResource, Match, Switch } from 'solid-js';
import { api } from './api';
import SessionView from './SessionView';

/** One browser tab is one session: `/s/<id>`. `/` starts a new session. */
export default function App() {
  const [id] = createResource(async () => {
    const m = /^\/s\/([a-z0-9]+)/.exec(location.pathname);
    if (m) return m[1];
    const { id } = await api.createSession();
    history.replaceState(null, '', `/s/${id}`);
    return id;
  });
  return (
    <Switch>
      <Match when={id.error}>
        <div class="banner error">Could not start a session: {String(id.error)}</div>
      </Match>
      <Match when={id()}>{(sid) => <SessionView id={sid()} />}</Match>
    </Switch>
  );
}
