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

-- KIS Developers OAuth 접근토큰 영구저장. Render 무료 요금제가 비활성 시 재시작되면
-- 메모리 캐시가 날아가는데, KIS 토큰은 "1일 1회 발급 원칙"이라 재시작마다 새로 받으면 안 됨.
-- 행 하나만 씀(id=1 고정).
create table if not exists kis_oauth_token (
  id smallint primary key,
  access_token text not null,
  expires_at timestamptz not null
);

-- Phase 3: 관심종목. domestic=true면 6자리 종목코드, false면 해외 티커.
-- 스케줄러가 매일 새벽 이 목록을 돌면서 골든/데드크로스·거래량 급증 신호를 체크해 텔레그램으로 알림.
create table if not exists watchlist (
  id bigint generated always as identity primary key,
  symbol text not null,
  domestic boolean not null,
  added_at timestamptz not null default now(),
  unique (symbol)
);
