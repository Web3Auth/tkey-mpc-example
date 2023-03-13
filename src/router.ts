import { createBrowserRouter } from "react-router-dom";

import Auth from "./Auth";
import Login from "./Login";

const router = createBrowserRouter([
  {
    path: "/",
    Component: Login,
  },
  {
    path: "auth",
    Component: Auth,
  },
  {
    path: "*",
    Component: Login,
  },
]);

export default router;
