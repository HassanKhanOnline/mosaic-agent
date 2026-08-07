import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { supabase } from './lib/supabase';
import Login from './pages/Login';
import Search from './pages/Search';
import Admin from './pages/Admin';
export default function App() {
    const [session, setSession] = useState(null);
    const [ready, setReady] = useState(false);
    useEffect(() => {
        supabase.auth.getSession().then(({ data }) => {
            setSession(data.session);
            setReady(true);
        });
        const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
        return () => sub.subscription.unsubscribe();
    }, []);
    if (!ready)
        return null;
    if (!session)
        return _jsx(Login, {});
    return (_jsxs("div", { className: "flex min-h-full flex-col", children: [_jsx(Nav, { email: session.user.email ?? '' }), _jsx("main", { className: "flex-1", children: _jsxs(Routes, { children: [_jsx(Route, { path: "/", element: _jsx(Search, {}) }), _jsx(Route, { path: "/admin", element: _jsx(Admin, {}) }), _jsx(Route, { path: "*", element: _jsx(Navigate, { to: "/", replace: true }) })] }) })] }));
}
function Nav({ email }) {
    const { pathname } = useLocation();
    const link = (to, label) => (_jsx(Link, { to: to, className: `rounded px-3 py-1.5 text-sm ${pathname === to ? 'bg-clay-200 font-medium' : 'hover:bg-clay-100'}`, children: label }));
    return (_jsxs("header", { className: "flex items-center gap-2 border-b border-clay-200 bg-white px-5 py-3", children: [_jsx("span", { className: "mr-3 font-semibold tracking-tight", children: "Mosaic" }), link('/', 'Search'), link('/admin', 'Admin'), _jsx("span", { className: "ml-auto text-xs text-clay-600", children: email }), _jsx("button", { onClick: () => supabase.auth.signOut(), className: "rounded px-2 py-1 text-xs text-clay-600 hover:bg-clay-100", children: "Sign out" })] }));
}
