import { type ReactNode } from 'react';
import { Typography, Slider, Stack } from '@mui/material';

interface ResourceSliderProps {
  icon: ReactNode;
  label: string;
  // Secondary text after the label (e.g. an accelerator's raw resource key when the label
  // is a friendly name).
  sublabel?: string;
  value: number;
  // '' renders bare numbers (accelerator counts have no unit word).
  unit: string;
  min: number;
  max: number;
  step: number;
  // A pinned axis (min === max) has nothing to choose; disable instead of rendering a
  // zero-length track.
  disabled?: boolean;
  onChange: (value: number) => void;
}

export function ResourceSlider({ icon, label, sublabel, value, unit, min, max, step, disabled, onChange }: ResourceSliderProps) {
  const withUnit = (n: number) => (unit ? `${n} ${unit}` : `${n}`);
  return (
    <Stack spacing={0.5}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Stack direction="row" alignItems="center" spacing={1}>
          {icon}
          <Typography variant="body2">{label}</Typography>
          {sublabel && (
            <Typography variant="caption" color="text.secondary">
              {sublabel}
            </Typography>
          )}
        </Stack>
        <Typography variant="body2" fontFamily="monospace" fontWeight={600}>
          {withUnit(value)}
        </Typography>
      </Stack>
      <Slider value={value} onChange={(_, v) => onChange(v as number)} min={min} max={max} step={step} size="small" disabled={disabled} aria-label={label} />
      <Stack direction="row" justifyContent="space-between">
        <Typography variant="caption" color="text.secondary">
          {withUnit(min)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {withUnit(max)}
        </Typography>
      </Stack>
    </Stack>
  );
}
