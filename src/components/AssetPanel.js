import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { FACETS } from '../../shared/vocab';
export default function AssetPanel({ id, onClose }) {
    const [detail, setDetail] = useState(null);
    const [vocab, setVocab] = useState([]);
    const [editing, setEditing] = useState(false);
    const load = () => api.asset(id).then(setDetail);
    useEffect(() => {
        load();
        api.vocab().then((v) => setVocab(v.facets));
    }, [id]);
    useEffect(() => {
        const onKey = (e) => e.key === 'Escape' && onClose();
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    if (!detail)
        return null;
    const { asset, analysis, tags, occurrences } = detail;
    async function toggleTag(tag, has) {
        if (has)
            await api.removeTag(id, tag.id);
        else
            await api.addTag(id, tag.id);
        await load();
    }
    return (_jsx("div", { className: "fixed inset-0 z-20 flex justify-end bg-black/30", onClick: onClose, children: _jsxs("div", { onClick: (e) => e.stopPropagation(), className: "flex w-full max-w-2xl flex-col overflow-y-auto bg-white", children: [_jsxs("div", { className: "flex items-center gap-3 border-b border-clay-200 px-5 py-3", children: [_jsx("h2", { className: "truncate text-sm font-semibold", children: analysis?.product_name ?? occurrences[0]?.filename ?? 'Image' }), _jsx("button", { onClick: onClose, className: "ml-auto rounded px-2 py-1 text-sm hover:bg-clay-100", children: "Close" })] }), _jsx("img", { src: asset.url, alt: "", className: "max-h-[55vh] w-full bg-clay-100 object-contain" }), _jsxs("div", { className: "space-y-5 p-5", children: [analysis?.description && _jsx("p", { className: "text-sm", children: analysis.description }), _jsxs("dl", { className: "grid grid-cols-2 gap-x-6 gap-y-1 text-xs", children: [_jsx(Row, { label: "Product", value: analysis?.product_name }), _jsx(Row, { label: "Code", value: analysis?.product_code }), _jsx(Row, { label: "Size", value: analysis?.size_mm }), _jsx(Row, { label: "Dimensions", value: asset.width ? `${asset.width} × ${asset.height}` : null }), _jsx(Row, { label: "Times sent", value: String(asset.occurrence_count) }), _jsx(Row, { label: "Last sent", value: asset.last_seen_at ? new Date(asset.last_seen_at).toLocaleDateString() : null })] }), _jsxs("section", { children: [_jsxs("div", { className: "mb-2 flex items-center gap-2", children: [_jsx("h3", { className: "text-xs font-medium uppercase tracking-wide text-clay-600", children: "Tags" }), _jsx("button", { onClick: () => setEditing((e) => !e), className: "text-xs text-clay-600 underline", children: editing ? 'Done' : 'Edit' })] }), editing ? (_jsx("div", { className: "space-y-3", children: vocab.map((facet) => (_jsxs("div", { children: [_jsx("p", { className: "mb-1 text-[11px] text-clay-600", children: facet.label }), _jsx("div", { className: "flex flex-wrap gap-1", children: facet.values.map((v) => {
                                                    const has = tags.some((t) => t.tag_id === v.id);
                                                    return (_jsx("button", { onClick: () => toggleTag(v, has), className: `rounded-full px-2 py-0.5 text-xs ${has ? 'bg-clay-900 text-white' : 'bg-clay-100 hover:bg-clay-200'}`, children: v.value }, v.id));
                                                }) })] }, facet.key))) })) : (_jsxs("div", { className: "flex flex-wrap gap-1", children: [FACETS.flatMap(({ key }) => tags.filter((t) => t.tags?.facet === key)).map((t) => (_jsx("span", { title: t.source === 'manual' ? 'Added by hand' : 'Suggested by the tagger', className: `rounded-full px-2 py-0.5 text-xs ${
                                            // A hand-added tag is a correction, and it should look
                                            // different from a guess — that is the whole feedback loop.
                                            t.source === 'manual'
                                                ? 'bg-clay-900 text-white'
                                                : 'bg-clay-100 text-clay-900'}`, children: t.tags?.value }, `${t.tag_id}-${t.source}`))), tags.length === 0 && _jsx("span", { className: "text-xs text-clay-600", children: "Not tagged yet." })] }))] }), occurrences.length > 0 && (_jsxs("section", { children: [_jsx("h3", { className: "mb-2 text-xs font-medium uppercase tracking-wide text-clay-600", children: occurrences.length === 1
                                        ? 'From the email'
                                        : `Attached to ${occurrences.length} messages` }), _jsx("div", { className: "space-y-2", children: occurrences.map((o, i) => {
                                        const msg = o.messages;
                                        if (!msg)
                                            return null;
                                        return (
                                        // The first email is open because it usually names the
                                        // product; the rest are one click away, each with its own
                                        // thread text — often a different customer conversation.
                                        _jsxs("details", { open: i === 0, className: "rounded border border-clay-200", children: [_jsxs("summary", { className: "cursor-pointer list-none px-3 py-2", children: [_jsx("span", { className: "block truncate text-sm font-medium", children: msg.threads?.subject ?? '(no subject)' }), _jsxs("span", { className: "block truncate text-xs text-clay-600", children: [msg.from_addr, msg.to_addrs?.length > 0 && _jsxs(_Fragment, { children: [" \u2192 ", msg.to_addrs.join(', ')] }), msg.sent_at && _jsxs(_Fragment, { children: [" \u00B7 ", new Date(msg.sent_at).toLocaleDateString()] })] })] }), _jsx("p", { className: "max-h-48 overflow-y-auto whitespace-pre-wrap border-t border-clay-200 bg-clay-50 p-3 text-xs", children: msg.threads?.body_text?.slice(0, 3000) || '(no text in this thread)' })] }, i));
                                    }) })] }))] })] }) }));
}
function Row({ label, value }) {
    if (!value)
        return null;
    return (_jsxs(_Fragment, { children: [_jsx("dt", { className: "text-clay-600", children: label }), _jsx("dd", { children: value })] }));
}
