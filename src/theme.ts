import { createTheme } from '@mui/material/styles';

const shared = {
  typography: {
    fontFamily: '"Source Sans 3", "Source Sans Pro", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    h1: { fontSize: '2.5rem', fontWeight: 700 },
    h2: { fontSize: '1.875rem', fontWeight: 700, letterSpacing: '-0.01em' },
    h3: { fontSize: '1.5rem', fontWeight: 600 },
    h4: { fontSize: '1.25rem', fontWeight: 600 },
    h5: { fontSize: '1.125rem', fontWeight: 600 },
    h6: { fontSize: '0.9375rem', fontWeight: 600 },
    body1: { fontSize: '1rem', fontWeight: 400 },
    body2: { fontSize: '0.875rem', fontWeight: 400 },
    caption: { fontSize: '0.75rem' },
    button: { fontSize: '0.875rem', fontWeight: 600, textTransform: 'none' as const },
  },
  shape: { borderRadius: 10 },
  components: {
    MuiButton: {
      styleOverrides: {
        root: { borderRadius: 8, textTransform: 'none' as const },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { borderRadius: 6, fontWeight: 500 },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: { borderRadius: 10 },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: { borderRadius: 10 },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: { '& .MuiOutlinedInput-root': { borderRadius: 8 } },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: { borderRadius: 10 },
      },
    },
  },
};

export const lightTheme = createTheme({
  ...shared,
  palette: {
    mode: 'light',
    primary: { main: '#F37626', light: '#F59B5C', dark: '#D35F15' },
    secondary: { main: '#616161', light: '#757575', dark: '#4D4D4D' },
    success: { main: '#2E7D32', light: '#4CAF50', dark: '#1B5E20' },
    warning: { main: '#ED6C02', light: '#FF9800', dark: '#E65100' },
    error: { main: '#D32F2F', light: '#EF5350', dark: '#C62828' },
    info: { main: '#757575', light: '#9E9E9E', dark: '#616161' },
    background: { default: '#FAFAFA', paper: '#FFFFFF' },
    text: { primary: '#4D4D4D', secondary: '#757575', disabled: '#9E9E9E' },
    divider: 'rgba(0, 0, 0, 0.08)',
  },
});

export const darkTheme = createTheme({
  ...shared,
  palette: {
    mode: 'dark',
    primary: { main: '#F59B5C', light: '#F7B98A', dark: '#F37626' },
    secondary: { main: '#9E9E9E', light: '#BDBDBD', dark: '#757575' },
    success: { main: '#66BB6A', light: '#81C784', dark: '#388E3C' },
    warning: { main: '#FFA726', light: '#FFB74D', dark: '#F57C00' },
    error: { main: '#EF5350', light: '#E57373', dark: '#D32F2F' },
    info: { main: '#9E9E9E', light: '#BDBDBD', dark: '#757575' },
    background: { default: '#1A1A1A', paper: '#242424' },
    text: { primary: '#EEEEEE', secondary: '#9E9E9E', disabled: '#616161' },
    divider: 'rgba(255, 255, 255, 0.10)',
  },
});
