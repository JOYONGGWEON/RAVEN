-- 프로그램매매/공매도/신용잔고/대차거래 4종 수급데이터 캐시 테이블
-- API마다 응답 필드가 전부 달라서 원본 JSON을 그대로 저장하고,
-- 필요한 필드는 애플리케이션 코드에서 raw_data에서 꺼내 씀.
create table if not exists supply_demand_daily (
  id bigint generated always as identity primary key,
  symbol text not null,
  trade_date date not null,
  data_type text not null check (data_type in ('program_trade', 'short_sale', 'credit_balance', 'loan_trans')),
  raw_data jsonb not null,
  fetched_at timestamptz not null default now(),
  unique (symbol, trade_date, data_type)
);

create index if not exists idx_supply_demand_symbol_date
  on supply_demand_daily (symbol, trade_date desc);
