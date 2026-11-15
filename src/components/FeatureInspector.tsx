import React, { useState } from 'react';
import { X, Copy, Check, Building2, Route, Landmark } from 'lucide-react';
import type { SelectedOvertureFeature } from '../types/geospatial';

interface FeatureInspectorProps {
  feature: SelectedOvertureFeature;
  onClose: () => void;
}

export const FeatureInspector: React.FC<FeatureInspectorProps> = ({ feature, onClose }) => {
  const [copied, setCopied] = useState(false);

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(feature.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard fallback ignored
    }
  };

  const Icon =
    feature.layerType === 'segment'
      ? Route
      : feature.layerType === 'infrastructure'
        ? Landmark
        : Building2;

  const typeLabel =
    feature.layerType === 'building'
      ? 'Overture Building'
      : feature.layerType === 'building_part'
        ? 'Building Part'
        : feature.layerType === 'segment'
          ? 'Transportation Segment'
          : 'Civil Infrastructure';

  const hiddenKeys = new Set(['sources', 'names', 'id', '@id']);
  const displayEntries = Object.entries(feature.properties)
    .filter(([k, v]) => !hiddenKeys.has(k) && v !== undefined && v !== null && v !== '')
    .slice(0, 18);

  return (
    <aside className="w-[300px] shrink-0 bg-white border-l border-slate-200 flex flex-col h-full overflow-hidden z-20">
      <div className="px-4 py-2.5 border-b border-slate-200 flex items-center justify-between bg-[#F8FAFC]">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="w-3.5 h-3.5 text-cyan-600 shrink-0" />
          <span className="text-xs font-semibold text-slate-800 truncate">{typeLabel}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close Inspector"
          className="w-7 h-7 flex items-center justify-center rounded text-slate-500 hover:bg-slate-200/60 hover:text-slate-900 cursor-pointer shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-slate-200">
        {/* Identity Header */}
        <div className="p-4 space-y-2">
          <h3 className="text-sm font-semibold text-slate-900 leading-snug">{feature.title}</h3>
          <div className="flex items-center gap-2 text-[11px] text-slate-500">
            <span>{feature.subtype || feature.layerType}</span>
            {feature.featureClass && (
              <>
                <span aria-hidden="true">·</span>
                <span>{feature.featureClass}</span>
              </>
            )}
          </div>

          <div className="pt-1 flex items-center justify-between gap-2 bg-[#F8FAFC] border border-slate-200 rounded px-2.5 py-1.5">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">GERS ID</div>
              <div className="text-[11px] font-mono tabular-nums text-slate-700 truncate">
                {feature.id}
              </div>
            </div>
            <button
              type="button"
              onClick={handleCopyId}
              title="Copy GERS ID"
              className="p-1.5 text-slate-500 hover:text-slate-900 rounded hover:bg-slate-200/60 shrink-0 cursor-pointer"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* Calibrated Physical Metrics */}
        <div className="p-4 grid grid-cols-2 gap-3">
          {feature.height !== undefined && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-400">Height</div>
              <div className="text-base font-mono font-semibold tabular-nums text-slate-900">
                {feature.height.toFixed(1)}
                <span className="text-xs font-normal text-slate-500 ml-1">m</span>
              </div>
            </div>
          )}
          {feature.numFloors !== undefined && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-400">Floors</div>
              <div className="text-base font-mono font-semibold tabular-nums text-slate-900">
                {feature.numFloors}
              </div>
            </div>
          )}
          {feature.roofShape && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-400">Roof Shape</div>
              <div className="text-xs font-medium text-slate-800 capitalize mt-0.5">
                {feature.roofShape}
              </div>
            </div>
          )}
          {feature.surface && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-400">Surface</div>
              <div className="text-xs font-medium text-slate-800 capitalize mt-0.5">
                {feature.surface}
              </div>
            </div>
          )}
          <div className="col-span-2">
            <div className="text-[10px] uppercase tracking-wider text-slate-400">Coordinates</div>
            <div className="text-xs font-mono tabular-nums text-slate-700 mt-0.5">
              {feature.lngLat[1].toFixed(5)}°, {feature.lngLat[0].toFixed(5)}°
            </div>
          </div>
        </div>

        {/* Provenance Sources */}
        {feature.sources.length > 0 && (
          <div className="p-4 space-y-2">
            <div className="text-xs font-semibold text-slate-900">Data Provenance</div>
            <div className="space-y-1.5">
              {feature.sources.map((src, idx) => (
                <div
                  key={`${src.dataset || 'src'}-${idx}`}
                  className="text-xs bg-[#F8FAFC] border border-slate-200 rounded px-2.5 py-1.5 flex items-center justify-between gap-2"
                >
                  <span className="font-medium text-slate-800 truncate">
                    {src.dataset || 'Overture Contributor'}
                  </span>
                  {src.confidence !== undefined && (
                    <span className="font-mono text-[11px] tabular-nums text-slate-500 shrink-0">
                      {(src.confidence * 100).toFixed(0)}% conf
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Overture Schema Attributes */}
        <div className="p-4 space-y-2">
          <div className="text-xs font-semibold text-slate-900">Schema Attributes</div>
          <div className="divide-y divide-slate-100 border border-slate-200 rounded">
            {displayEntries.length === 0 ? (
              <div className="px-2.5 py-2 text-xs text-slate-400">No additional properties</div>
            ) : (
              displayEntries.map(([key, val]) => (
                <div
                  key={key}
                  className="px-2.5 py-1.5 flex items-start justify-between gap-3 text-[11px]"
                >
                  <span className="font-mono text-slate-500 shrink-0">{key}</span>
                  <span className="font-mono text-slate-900 text-right break-all">
                    {typeof val === 'object' ? JSON.stringify(val) : String(val)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </aside>
  );
};
