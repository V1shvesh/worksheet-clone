import { Navigate, Outlet } from "react-router-dom";
import { useMeQuery } from "./authApi";

export function RequireAuth() {
  const { data, isLoading, isError } = useMeQuery();

  if (isLoading) {
    return <p className="page">Loading…</p>;
  }

  if (isError || !data) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
