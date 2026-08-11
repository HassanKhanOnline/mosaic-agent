import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import AssetPanel from '../components/AssetPanel';
export default function Search() {
    const [facets, setFacets] = useState([]);
    const [selected, setSelected] = useState([]);
    const [untagged, setUntagged] = useState(false);
    const [input, setInput] = useState('');
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [open, setOpen] = useState(null);
    useEffect(() => {
        api.vocab().then((v) => setFacets(v.facets)).catch(() => { });
    }, []);
    // Debounced so typing doesn't fire an embedding call per keystroke — the
    // semantic half of the query costs a model round trip.
    useEffect(() => {
        const timer = setTimeout(() => setQuery(input), 300);
        return () => clearTimeout(timer);
    }, [input]);
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        api
            .search(query, selected, 0, untagged)
            .then((r) => !cancelled && setResults(r.results))
            .catch((e) => !cancelled && setError(String(e.message ?? e)))
            .finally(() => !cancelled && setLoading(false));
        return () => {
            cancelled = true;
        };
    }, [query, selected, untagged]);
    const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
    const selectedCount = selected.length;
    return (_jsxs("div", { className: "flex", children: [_jsxs("aside", { className: "w-56 shrink-0 border-r border-clay-200 p-4", children: [_jsxs("div", { className: "mb-3 flex items-center justify-between", children: [_jsx("span", { className: "text-xs font-medium uppercase tracking-wide text-clay-600", children: "Filters" }), selectedCount > 0 && (_jsxs("button", { onClick: () => setSelected([]), className: "text-xs text-clay-600 underline", children: ["Clear ", selectedCount] }))] }), _jsxs("label", { className: "mb-3 flex cursor-pointer items-center gap-2 text-xs font-medium", children: [_jsx("input", { type: "checkbox", checked: untagged, onChange: (e) => setUntagged(e.target.checked), className: "accent-clay-900" }), "Untagged only"] }), facets.map((facet) => (_jsx(FacetGroup, { facet: facet, selected: selected, onToggle: toggle }, facet.key)))] }), _jsxs("section", { className: "flex-1 p-5", children: [_jsx("input", { value: input, onChange: (e) => setInput(e.target.value), placeholder: "Calacatta 600x1200 \u2014 or: something warm and sandy for a bathroom floor", className: "w-full rounded border border-clay-200 bg-white px-4 py-2.5 text-sm" }), _jsx("p", { className: "mt-2 h-4 text-xs text-clay-600", children: error ? (_jsx("span", { className: "text-red-700", children: error })) : loading ? ('Searching…') : (`${results.length} image${results.length === 1 ? '' : 's'}`) }), _jsx("div", { className: "mt-4 grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3", children: results.map((r) => (_jsxs("button", { onClick: () => setOpen(r.id), className: "group overflow-hidden rounded border border-clay-200 bg-white text-left", children: [_jsx("img", { src: r.thumbUrl, alt: r.analysis?.description ?? '', loading: "lazy", className: "aspect-square w-full bg-clay-100 object-cover" }), _jsxs("div", { className: "p-2", children: [_jsx("p", { className: "truncate text-xs font-medium", children: r.analysis?.product_name ?? r.analysis?.description ?? r.filename ?? 'Untitled' }), _jsx("p", { className: "truncate text-[11px] text-clay-600", children: [r.analysis?.product_code, r.analysis?.size_mm].filter(Boolean).join(' · ') ||
                                                (r.occurrence_count > 1 ? `sent ${r.occurrence_count}×` : ' ') })] })] }, r.id))) }), !loading && results.length === 0 && (_jsx("p", { className: "mt-10 text-center text-sm text-clay-600", children: "Nothing matches. Try fewer filters, or describe the look rather than the name." }))] }), open && _jsx(AssetPanel, { id: open, onClose: () => setOpen(null) })] }));
}
function FacetGroup({ facet, selected, onToggle, }) {
    const active = useMemo(() => facet.values.filter((v) => selected.includes(v.id)).length, [facet.values, selected]);
    return (_jsxs("details", { open: active > 0, className: "mb-2 border-b border-clay-200 pb-2 last:border-0", children: [_jsxs("summary", { className: "cursor-pointer list-none text-sm font-medium", children: [facet.label, active > 0 && _jsxs("span", { className: "ml-1 text-xs text-clay-600", children: ["(", active, ")"] })] }), _jsx("div", { className: "mt-1.5 space-y-1", children: facet.values.map((v) => (_jsxs("label", { className: "flex cursor-pointer items-center gap-2 text-xs", children: [_jsx("input", { type: "checkbox", checked: selected.includes(v.id), onChange: () => onToggle(v.id), className: "accent-clay-900" }), v.value] }, v.id))) })] }));
}
