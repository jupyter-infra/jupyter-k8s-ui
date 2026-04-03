import { Avatar, IconButton, Tooltip } from '@mui/material';
import { strings } from '../../constants';
import styles from './Layout.module.css';

interface UserMenuProps {
  username: string;
}

export function UserMenu({ username }: UserMenuProps) {
  return (
    <Tooltip title={username}>
      <IconButton size="small" aria-label={strings.a11y.userMenu(username)}>
        <Avatar className={styles.avatar} alt={username}>
          {username.charAt(0).toUpperCase()}
        </Avatar>
      </IconButton>
    </Tooltip>
  );
}
