import React from 'react';
import { ShieldAlert, Box } from 'lucide-react';
import { REGION_PRESETS } from '../types/geospatial';
import type { RegionPreset } from '../types/geospatial';

interface TopBarProps {
  activePresetId: string | null;
  onSelectPreset: (preset: RegionPreset) => void;
  onExportSnapshot: () => void;
  droneMeshEnabled: boolean;
  onToggleDroneMesh: () => void;
  onOpenDroneInspector: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  activePresetId,
  onSelectPreset,
  onExportSnapshot,
  droneMeshEnabled,
  onToggleDroneMesh,
  onOpenDroneInspector,
}) => {
  return (
    <header className="h-11 shrink-0 bg-white border-b border-slate-200 px-5 flex items-center justify-between gap-6 z-30">
      <a
        href="#top"
        onClick={(e) => {
          e.preventDefault();
          onSelectPreset(REGION_PRESETS[0]);
        }}
        className="text-base font-semibold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
      >
        TerraGraph
      </a>

      <nav className="hidden md:flex items-center gap-6 overflow-x-auto" aria-label="Region Presets">
        {REGION_PRESETS.map((preset) => {
          const isActive = activePresetId === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => onSelectPreset(preset)}
              className={`h-11 px-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 border-b-2 cursor-pointer ${
                isActive
                  ? 'border-blue-600 text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-900 hover:border-slate-300'
              }`}
            >
              {preset.label}
            </button>
          );
        })}
      </nav>

      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onToggleDroneMesh}
          className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer ${
            droneMeshEnabled
              ? 'bg-cyan-700 border-cyan-700 text-white hover:bg-cyan-800'
              : 'bg-[#F8FAFC] border-slate-200 text-slate-700 hover:bg-slate-100'
          }`}
        >
          <ShieldAlert className="w-3.5 h-3.5" />
          {droneMeshEnabled ? '3D Drone Mesh: ON' : '3D Drone Mesh'}
        </button>

        {droneMeshEnabled && (
          <button
            type="button"
            onClick={onOpenDroneInspector}
            className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-200 bg-slate-900 text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer"
          >
            <Box className="w-3.5 h-3.5" />
            3D Mesh Inspector
          </button>
        )}

        <button
          type="button"
          onClick={onExportSnapshot}
          className="px-3.5 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          Export Snapshot
        </button>
      </div>
    </header>
  );
};
