-- ECLOUD migration 012: platform role templates are not deletable from a tenant connection
-- (T-15, TESTING.md §5.4). The `tenant_isolation` policies of 010 are FOR ALL and their USING
-- admits templates (organization_id IS NULL) so tenants can read them; DELETE checks only USING,
-- so ecloud_app could delete templates and their grants. UPDATE is already stopped by WITH CHECK.
-- A RESTRICTIVE policy is AND-ed with the permissive one, so `tenant_isolation` (one per table,
-- asserted by the RLS suites) stays the single permissive policy. Never edit 010: applied
-- checksums are immutable.
SET LOCAL lock_timeout = '5s';

CREATE POLICY template_delete_guard ON roles AS RESTRICTIVE FOR DELETE
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

CREATE POLICY template_delete_guard ON role_permissions AS RESTRICTIVE FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM roles r
     WHERE r.id = role_permissions.role_id
       AND r.organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
  ));
