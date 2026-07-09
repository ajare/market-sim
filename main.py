"""Entry point for `python -m sim [--commodities-csv ...]`."""
from cli import main, _parse_args

if __name__ == "__main__":
    # Parse
    args = _parse_args()
    main(
        commodities_csv=args.commodities_csv,
        locations_csv=args.locations_csv,
        routes_csv=args.routes_csv,
        companies_csv=args.companies_csv,
        pirate_brigades_csv=args.pirate_brigades_csv,
        json_report_dir=args.json_report_dir,
    )
