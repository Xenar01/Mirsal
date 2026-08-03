import { useTranslation } from 'react-i18next';
import Modal from '../../components/Modal';

/*
 * Minimal stub — Task 4 replaces this with the full create-collection wizard
 * (title + departments textarea + optional template/password/deadline, then
 * the created-link screen). Kept trivial here so CollectionsView's "new"
 * button and the router have something real to mount for tests/typecheck.
 */
export default function CreateCollectionModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal open onClose={onClose} title={t('collections.create.title')}>
      <span />
    </Modal>
  );
}
