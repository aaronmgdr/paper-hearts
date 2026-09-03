/* @refresh reload */
import { render } from "solid-js/web";
import { Router, Route } from "@solidjs/router";
import App from "./App";
import Today from "./screens/Today";
import Archive from "./screens/Archive";
import Settings from "./screens/Settings";
import Onboarding from "./screens/Onboarding";
import Privacy from "./screens/Privacy";
import DeviceLink from "./screens/DeviceLink";
import Recovery from "./screens/Recovery";
import Restore from "./screens/Restore";
import "./styles/global.css";

render(
  () => (
    <Router root={App}>
      <Route path="/" component={Today} />

      <Route path="/archive" component={Archive} />
      <Route path="/archive/:dayId" component={Today} />
      <Route path="/settings" component={Settings} />
      <Route path="/onboarding" component={Onboarding} />
      <Route path="/privacy" component={Privacy} />
      <Route path="/device-link" component={DeviceLink} />
      <Route path="/recovery" component={Recovery} />
      <Route path="/restore" component={Restore} />
    </Router>
  ),
  document.getElementById("root")!
);
