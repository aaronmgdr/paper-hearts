/* @refresh reload */
import { render } from "solid-js/web";
import { Router, Route } from "@solidjs/router";
import App from "./App";
import Today from "./screens/Today";
import Archive from "./screens/Archive";
import Settings from "./screens/Settings";
import Onboarding from "./screens/Onboarding";
import Privacy from "./screens/Privacy";
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
    </Router>
  ),
  document.getElementById("root")!
);
