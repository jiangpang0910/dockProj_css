-- 0008: logins. A user project belongs to the account that created it (infrastructure.md §5). Templates have no
-- owner. Projects made before this migration stay NULL: only admins see them, and the idle cleanup removes them.
ALTER TABLE project ADD COLUMN owner text CHECK (owner IS NULL OR length(trim(owner)) > 0);
CREATE INDEX project_owner ON project (owner, last_opened_at DESC) WHERE template_key IS NULL;
