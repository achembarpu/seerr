import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsSearch from '@app/components/Settings/SettingsSearch';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const SearchSettingsPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsSearch />
    </SettingsLayout>
  );
};
export default SearchSettingsPage;
