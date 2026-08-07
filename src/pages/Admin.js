import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
export default function Admin() {
    const [status, setStatus] = useState(null);
    const [busy, setBusy] = useState(null);
    const [error, setError] = useState(null);
    const [params] = useSearchParams();
    const load = () => api.status().then(setStatus).catch((e) => setError(String(e.message ?? e)));
    useEffect(() => {
        load();
        // A running backfill moves one batch a minute; polling keeps the numbers
        // honest without a websocket.
        const timer = setInterval(load, 5000);
        return () => clearInterval(timer);
    }, []);
    async function act(name, fn) {
        setBusy(name);
        setError(null);
        try {
            await fn();
            await load();
        }
        catch (e) {
            setError(String(e.message ?? e));
        }
        setBusy(null);
    }
    async function connect() {
        setBusy('connect');
        try {
            const { url } = await api.connectUrl();
            window.location.href = url;
        }
        catch (e) {
            setError(String(e.message ?? e));
            setBusy(null);
        }
    }
    if (!status)
        return _jsx("div", { className: "p-6 text-sm text-clay-600", children: "Loading\u2026" });
    const run = status.run;
    const running = run?.status === 'running';
    const counts = status.counts ?? {};
    return (_jsxs("div", { className: "mx-auto max-w-3xl space-y-8 p-6", children: [params.get('connected') && (_jsxs(Banner, { tone: "ok", children: ["Connected ", params.get('connected'), ". Start the backfill below."] })), params.get('error') && _jsxs(Banner, { tone: "bad", children: ["Google returned: ", params.get('error')] }), error && _jsx(Banner, { tone: "bad", children: error }), _jsxs("section", { children: [_jsx("h2", { className: "text-sm font-semibold", children: "Mailbox" }), status.account ? (_jsxs("div", { className: "mt-2 rounded border border-clay-200 bg-white p-4 text-sm", children: [_jsx("p", { className: "font-medium", children: status.account.email }), _jsxs("p", { className: "mt-1 text-xs text-clay-600", children: ["Connected ", new Date(status.account.connected_at).toLocaleString()] }), status.account.invalid_since && (_jsxs("div", { className: "mt-3 rounded bg-amber-50 p-3 text-xs", children: [_jsx("p", { className: "font-medium text-amber-900", children: "Google is rejecting the token." }), _jsx("p", { className: "mt-1 text-amber-900", children: "On a consumer @gmail.com account with the OAuth app still in Testing status, refresh tokens expire every 7 days \u2014 this is expected, and reconnecting fixes it. The sync resumes from where it stopped." }), _jsx("button", { onClick: connect, className: "mt-2 rounded bg-clay-900 px-3 py-1.5 text-xs font-medium text-white", children: "Reconnect" })] }))] })) : (_jsxs("div", { className: "mt-2 rounded border border-clay-200 bg-white p-4", children: [_jsxs("p", { className: "text-sm", children: ["No mailbox connected. This will authorise read-only Gmail access for", ' ', _jsx("span", { className: "font-medium", children: status.mailbox }), "."] }), !status.configured && (_jsx("p", { className: "mt-2 text-xs text-amber-800", children: "GOOGLE_CLIENT_ID or ANTHROPIC_API_KEY is not set \u2014 see .dev.vars." })), _jsx("button", { onClick: connect, disabled: busy === 'connect' || !status.configured, className: "mt-3 rounded bg-clay-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50", children: "Connect Gmail" })] }))] }), _jsxs("section", { children: [_jsx("h2", { className: "text-sm font-semibold", children: "Library" }), _jsxs("div", { className: "mt-2 grid grid-cols-4 gap-3", children: [_jsx(Stat, { label: "Searchable", value: counts.ready ?? 0 }), _jsx(Stat, { label: "Awaiting tagging", value: counts.pending ?? 0 }), _jsx(Stat, { label: "Filtered out", value: counts.rejected ?? 0 }), _jsx(Stat, { label: "Boilerplate", value: counts.suppressed ?? 0 })] }), _jsx("p", { className: "mt-2 text-xs text-clay-600", children: "Filtered and boilerplate images are still on disk. Open one from search and set it back to searchable if a threshold got it wrong." })] }), _jsxs("section", { children: [_jsx("h2", { className: "text-sm font-semibold", children: "Sync" }), _jsxs("div", { className: "mt-2 rounded border border-clay-200 bg-white p-4 text-sm", children: [run ? (_jsxs(_Fragment, { children: [_jsxs("p", { children: [_jsx("span", { className: "font-medium capitalize", children: run.kind }), " \u2014 ", run.status] }), _jsxs("p", { className: "mt-1 text-xs text-clay-600", children: [run.threads_seen, " threads, ", run.images_stored, " new images \u00B7 started", ' ', new Date(run.started_at).toLocaleString()] }), run.error && _jsx("p", { className: "mt-2 text-xs text-red-700", children: run.error })] })) : (_jsx("p", { className: "text-clay-600", children: "No run yet." })), _jsxs("div", { className: "mt-3 flex gap-2", children: [_jsx("button", { onClick: () => act('backfill', api.backfill), disabled: !status.account || running || busy !== null, className: "rounded bg-clay-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40", children: "Start backfill" }), _jsx("button", { onClick: () => act('tick', api.tick), disabled: busy !== null, className: "rounded border border-clay-200 px-3 py-1.5 text-xs", children: "Run one batch now" }), running && (_jsx("button", { onClick: () => act('cancel', api.cancel), disabled: busy !== null, className: "rounded border border-clay-200 px-3 py-1.5 text-xs", children: "Cancel" }))] }), _jsxs("p", { className: "mt-2 text-xs text-clay-600", children: ["The backfill advances one batch a minute on its own. \"Run one batch now\" is for watching it start, and is the only way to make progress under", ' ', _jsx("code", { children: "wrangler dev" }), ", where cron triggers do not fire."] })] })] })] }));
}
function Stat({ label, value }) {
    return (_jsxs("div", { className: "rounded border border-clay-200 bg-white p-3", children: [_jsx("p", { className: "text-lg font-semibold tabular-nums", children: value.toLocaleString() }), _jsx("p", { className: "text-[11px] text-clay-600", children: label })] }));
}
function Banner({ tone, children }) {
    return (_jsx("div", { className: `rounded p-3 text-sm ${tone === 'ok' ? 'bg-green-50 text-green-900' : 'bg-red-50 text-red-900'}`, children: children }));
}
