import { IconButton, Tooltip } from '@mui/material';
import { DarkMode, LightMode } from '@mui/icons-material';
import { useTheme } from '../../context';
import { strings } from '../../constants';

export function ThemeSwitcher() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <Tooltip title={isDark ? strings.theme.switchToLight : strings.theme.switchToDark}>
      <IconButton size="small" onClick={toggleTheme} aria-label={strings.theme.toggle}>
        {isDark ? <LightMode fontSize="small" /> : <DarkMode fontSize="small" />}
      </IconButton>
    </Tooltip>
  );
}
