import { type ReactNode } from 'react';
import { Typography, Slider, Stack } from '@mui/material';

interface ResourceSliderProps {
  icon: ReactNode;
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}

export function ResourceSlider({ icon, label, value, unit, min, max, step, onChange }: ResourceSliderProps) {
  return (
    <Stack spacing={0.5}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Stack direction="row" alignItems="center" spacing={1}>
          {icon}
          <Typography variant="body2">{label}</Typography>
        </Stack>
        <Typography variant="body2" fontFamily="monospace" fontWeight={600}>
          {value} {unit}
        </Typography>
      </Stack>
      <Slider value={value} onChange={(_, v) => onChange(v as number)} min={min} max={max} step={step} size="small" aria-label={label} />
      <Stack direction="row" justifyContent="space-between">
        <Typography variant="caption" color="text.secondary">
          {min} {unit}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {max} {unit}
        </Typography>
      </Stack>
    </Stack>
  );
}
