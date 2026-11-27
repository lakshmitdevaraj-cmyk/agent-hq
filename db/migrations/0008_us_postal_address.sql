-- R9 / V3: in the US a postal address is required in the footer. When it is required and blank, the app warns and
-- does not send (P2 chunk 6). 0005 seeded false (today's behaviour); this changes the data, not the table.

update country_profiles set postal_address_required = true where code = 'US';

comment on column country_profiles.postal_address_required is
  'true: the footer must carry a postal address; when it is blank, warn and do not send (US: true since 0008)';
