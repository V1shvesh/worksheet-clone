import { Provider } from "react-redux";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { LoginPage } from "../features/auth/LoginPage";
import { RequireAuth } from "../features/auth/RequireAuth";
import { SignupPage } from "../features/auth/SignupPage";
import { WorkbookPage } from "../features/workbooks/WorkbookPage";
import { WorkbooksPage } from "../features/workbooks/WorkbooksPage";
import { store } from "./store";

export function App() {
  return (
    <Provider store={store}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route element={<RequireAuth />}>
            <Route path="/" element={<WorkbooksPage />} />
            <Route path="/workbooks/:id" element={<WorkbookPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </Provider>
  );
}
