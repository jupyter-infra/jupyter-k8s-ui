import { Component, type ReactNode } from 'react';
import { Typography, Button, Box } from '@mui/material';
import { ErrorOutline } from '@mui/icons-material';
import { strings } from '../../constants';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined });
    window.location.href = '/';
  };

  render() {
    if (this.state.hasError) {
      return (
        <Box
          display="flex"
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          minHeight="100vh"
          p={4}
          sx={{ textAlign: 'center' }}
        >
          <ErrorOutline color="error" sx={{ fontSize: 64, mb: 2 }} />
          <Typography variant="h4" gutterBottom>{strings.error.title}</Typography>
          <Box maxWidth={400}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {strings.error.description}
            </Typography>
          </Box>
          <Button variant="contained" onClick={this.handleReset}>
            {strings.error.goHome}
          </Button>
        </Box>
      );
    }
    return this.props.children;
  }
}
